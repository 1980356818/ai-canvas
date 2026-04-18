package com.aicat.server.mapper;

import com.aicat.server.entity.RedeemCode;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface RedeemCodeMapper extends BaseMapper<RedeemCode> {
    @Select("SELECT * FROM redeem_code WHERE code = #{code} FOR UPDATE")
    RedeemCode selectForUpdate(String code);
}
